/**
 * AI Table — sit down with computer players.
 *
 * One screen between the Play tab and the table, for the reason Quick Play has
 * one: the terms are stated BEFORE the table opens, not discovered afterwards.
 * Here the terms are that the chips are the table's own, that nothing about the
 * table is ranked, and what the computer players can and cannot see — which is
 * the claim a player most needs to be able to trust.
 *
 * There are no options. How many computer players, where the player sits and
 * the stakes are fixed, server-side, in one place (`AI_TABLE_*` in
 * `shared/blackjack/rules.ts`); this screen reads those figures rather than
 * typing them.
 *
 * The table itself is the SHARED table screen, `/table/[gameId]`, exactly as
 * every other server table is — there is no second blackjack screen.
 */

import { useCallback, useEffect, useMemo } from "react";
import { router } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { ConnectPlayerButton } from "../../src/components/ui/ConnectPlayerButton";
import { colors, layout, spacing } from "../../src/design/tokens";
import { formatChips } from "../../src/design/typography";
import {
  AI_TABLE_MAX_BET,
  AI_TABLE_MIN_BET,
  AI_TABLE_SEAT_COUNT,
  AI_TABLE_STACK,
} from "../../shared/blackjack";
import { useAuthStore } from "../../src/features/auth/auth-store";
import { useAiTableStore } from "../../src/features/ai-table";
import {
  describeActiveSession,
  describeActiveSessionMode,
  resumeTargetFor,
  selectActiveSession,
  useActiveSessionStore,
} from "../../src/features/table";

/** "two", for the copy. Derived from the configuration rather than typed. */
function computerPlayerCount(): string {
  const count = AI_TABLE_SEAT_COUNT - 1;
  return count === 1 ? "one computer player" : count === 2 ? "two computer players" : `${count} computer players`;
}

export default function AiTableSetup() {
  const configured = useAuthStore((state) => state.configured);
  const configurationMessage = useAuthStore((state) => state.configurationMessage);
  const userId = useAuthStore((state) => state.session?.account.userId ?? null);

  const opening = useAiTableStore((state) => state.opening);
  const notice = useAiTableStore((state) => state.notice);
  const open = useAiTableStore((state) => state.open);
  const clearNotice = useAiTableStore((state) => state.clearNotice);

  const activeStatus = useActiveSessionStore((state) => state.status);
  const refreshActive = useActiveSessionStore((state) => state.refresh);

  /*
   * Where the player is already seated, asked before anything is offered. A
   * player at another table cannot open this one — one live seat per player —
   * and a player already at an AI table should be taken back to it.
   */
  useEffect(() => {
    clearNotice();
    void refreshActive();
  }, [userId, clearNotice, refreshActive]);

  // Derived from subscribed state with `useMemo`, never a getter during render:
  // the React Compiler freezes a getter's first answer.
  const active = useMemo(() => selectActiveSession(activeStatus), [activeStatus]);
  const atAnAiTable = active?.mode === "ai_table";

  const start = useCallback(() => {
    void (async () => {
      const opened = await open();
      if (!opened) return;
      router.replace({
        pathname: "/table/[gameId]",
        params: { gameId: opened.gameId, seatId: opened.seatId },
      });
    })();
  }, [open]);

  if (!configured || userId === null) {
    return (
      <SafeAreaView style={styles.screen} edges={["top"]}>
        <BackBar />
        <ScrollView contentContainerStyle={styles.content}>
          <SurfaceCard>
            <AppText variant="sectionTitle">Practice plays the same game</AppText>
            <AppText variant="body" color="textSecondary">
              {configured
                ? "AI tables are dealt on the server, so they need your player identity. No email or password is needed. Practice uses the same rules and works offline."
                : (configurationMessage ?? "Online play is not available in this build.")}
            </AppText>
          </SurfaceCard>
          <Button
            label="Play Practice"
            onPress={() => router.replace("/game/practice")}
            testID="ai-table-practice"
          />
          {configured ? <ConnectPlayerButton testID="ai-table-connect" /> : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <BackBar />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <AppText variant="pageTitle" accessibilityRole="header">
            AI Table
          </AppText>
          <AppText variant="body" color="textSecondary">
            {`You and ${computerPlayerCount()}, one dealer, one shoe.`}
          </AppText>
        </View>

        {/*
          The resume card, first. Inert card, Button inside: a labelled
          `Pressable` replaces the text of everything within it in the iOS
          accessibility tree.
        */}
        {active ? (
          <SurfaceCard testID="ai-table-resume-card">
            <AppText variant="sectionTitle">
              {atAnAiTable ? "Your AI table is waiting" : "You are still at a table"}
            </AppText>
            <AppText variant="body" color="textSecondary">
              {describeActiveSession(active)}
            </AppText>
            <Button
              label={atAnAiTable ? "Return to your AI table" : `Return to ${describeActiveSessionMode(active.mode)}`}
              onPress={() => router.replace(resumeTargetFor(active) as never)}
              testID="ai-table-resume"
            />
          </SurfaceCard>
        ) : null}

        <SurfaceCard>
          <AppText variant="overline" color="textSecondary">
            The computer players
          </AppText>
          <AppText variant="body" color="textSecondary">
            {"Each one is marked AI at the table. They are dealt from the same shoe as you and " +
              "see only what any player at the table sees: their own cards and the dealer's " +
              "face-up card. They play basic strategy, bet the table minimum, and never change " +
              "the cards."}
          </AppText>
        </SurfaceCard>

        <SurfaceCard>
          <AppText variant="overline" color="textSecondary">
            Table chips
          </AppText>
          <AppText variant="bodyStrong" numeric testID="ai-table-stack">
            {`${formatChips(AI_TABLE_STACK)} for every seat`}
          </AppText>
          <AppText variant="caption" color="textSecondary">
            {`Bets ${formatChips(AI_TABLE_MIN_BET)}–${formatChips(AI_TABLE_MAX_BET)}. These chips belong to the table: nothing comes out of your balance and nothing goes back to it. If you run out, you can start again from the full amount.`}
          </AppText>
        </SurfaceCard>

        <UnavailableNote>
          Unranked. Hands here earn no XP and change no statistics, accuracy or leaderboard.
        </UnavailableNote>

        {!atAnAiTable ? (
          <Button
            label={opening ? "Opening…" : "Sit down"}
            onPress={start}
            disabled={opening || active !== null}
            testID="ai-table-start"
          />
        ) : null}

        {notice ? (
          <AppText variant="caption" color="warning" testID="ai-table-notice">
            {notice}
          </AppText>
        ) : null}
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
  header: { gap: spacing.xs },
});
